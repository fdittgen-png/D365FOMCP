# Trace Insight — Lean Concept (2026-09-11, v2)

Two read tools on the existing KB server, one small snapshot built from the local trace sinks, the
KPIs in the report that already exists. No new server, no new Azure resource, no new connector, no new auth path.
About **2 days** to build, minutes per week to run.

v2 replaces the morning draft (six-server design, five tools, Table Storage reader). What was cut
and why is in §7. Companions: `ERP-Trace-Module-Concept-and-Fable-Spec.md`,
`ERP-Trace-Capture-TDD.md`, `ERP-Trace-Ingest-Concept-2026-09-08.md` (E01–E44),
`MCP-Token-Efficiency-Concept.md`.

---

## 1. Value, stated as the three numbers it moves

| Value | Mechanism | Measured by |
|---|---|---|
| **Token efficiency** | A recurring request starts from the cheapest answered run's call recipe instead of exploring. A named functional entity is one call instead of the search → lookup_table → labels chain. | calls and est. tokens per answered investigation, per request key, before/after |
| **Response quality** | The recipe is the verified path, so fewer not-found, fewer wrong tables; the entity dossier carries key fields and field meaning, so assertions rest on the KB and Labels, not on recall. Discipline KPIs make the effect visible. | entity hit rate, waste share, exchange coverage, outcome; correctness only through traced eval runs |
| **Reusability for cleansing and migration** | Field-level usage heat per functional entity — which fields real investigations touch, in which context — is the Level-A telemetry the module concept promised. Served by `d365_entity_insight`; exportable later (OKF skipped, §6). | fields with usage, never-touched fields per entity |

Bounded honestly: a trace never says whether an answer was correct. Correctness enters only when an
eval run is traced under `request.key = eval.<suite>.<id>` (convention only, no code; #119 has no API
key on the box yet). Token counts are `bytes / 4`, labelled `est`, until one calibration session is
stored.

---

## 2. Architecture — reuse everything that exists

```
~/.claude/mcp-trace/*.ndjson (+ .sent)            config/semantic-vocabulary.json   SEMANTIC_DB_PATH (sem_mappings)
   hook: open/step/annotate/close · server: one record per call
                          │                                   │                      │
                          ▼                                   ▼                      ▼
              build/build-insight.js  ─────────────────────────────────────────────────▶  d365fo_insight.sqlite  (KB, seconds)
                          │                                                                        │
                          │                                                                        ▼
                          ▼                                                     KB server: d365_prior_art · d365_entity_insight
             ClaudeTrace /report  (existing v0.4.0; analyze.js gains the KPI set)                  │
                                                                                                   ▼
                                                                          Claude, first call of an investigation
```

**Why the local sinks are the complete source today.** Every trace originates on this machine: the
hook writes `hook.ndjson`, the stdio servers write `<service>.ndjson`, and `Push-LocalTraces.ps1`
ships both to the sink and renames them `.sent`. Azure connector tracing (F4) is blocked on an Entra
app registration, so nothing exists in Table Storage that is not also here. The builder therefore
reads files: no Storage auth, no PIM, no second SDK. When F4 lights up, one `--pull` option reads
`createStore().listRecords` the way the report does — an addition, not a redesign.

**Why the KB server and not a sixth server.** The two tools need the KB and Labels handles the KB
server already holds (`getKbDb`, `tryGetLabelsDb`), the vocabulary the semantic tools already load,
and the response helpers. A sixth server costs a Function, a deploy-list entry, a connector, a health
check and a second `tools/list` — recurring cost for two tools. On the KB server they cost ~4.5 KB of
`tools/list` (measured on registration, ceiling re-baselined deliberately) and are **outside
`CORE_TOOLS`**, so `core` clients pay nothing.

**Why the KPIs go to the report, not to a tool.** Quantification is read by a human weekly, not by
Claude per turn. `analyze.js` already computes shape, calls, bytes and pairs the hook/server twins;
adding waste classes, exchange coverage, entity hit rate and a `group_by` (request key, tool,
plugin version, week) is ~150 lines in a file with tests, and `/report/data?group=…` serves it. A
metrics tool would pay `tools/list` on every session for a number nobody reads at runtime.

**E01 stays true.** The sink has no LLM read path. The read path is a snapshot on the KB server built
from the same records — the downstream consumer the module concept §2.3 reserved. E01 gets a
one-line scope note in the ingest concept.

---

## 3. Snapshot — `d365fo_insight.sqlite`

Built by `npm run build:insight` (`INSIGHT_DB_PATH`, `INSIGHT_TRACE_DIR` default
`~/.claude/mcp-trace`); wired into `Publish-McpDataWeekly.ps1` and `Deploy.ps1 -Databases insight`
(a few MB). Read-only at serve time through `tryGetInsightDb()`; both tools return
`errorResult('db-error')` naming the build when it is absent — a coverage fact, not a crash.

| Table | Grain | Keys |
|---|---|---|
| `investigations` | one per investigation id | `request_key`, `interpreted` (≤200 chars, Claude's ERP-neutral text), `purpose`, `outcome`, `erp`, `t0`, `calls`, `bytes`, `steps`, `plugin_version`, `snapshot_date` |
| `calls` | one per paired call (hook ∪ server, subset match as in `analyze.js`) | `investigation_id`, `seq`, `service`, `tool`, `args_json` (sanitised, replayable), `kind`, `bytes`, `has_more`, `duration_ms`, `waste_class`, `step_intent` |
| `touched` | one per (call, object) | `kind`, `name`, `owner`, `functional_entity` (via vocabulary `primary_tables`/`data_entities` and `sem_mappings`) |
| `entity_usage` | one per (functional_entity, object, field) | `investigations`, `calls`, `last_seen`, `contexts` (distinct `functional_context`/`request_key`) |
| `recipes` | one per `request_key` | `runs`, `erps`, best/median `calls` and `bytes`, `recipe_json` = ordered `(tool, args)` of the cheapest `answered` run, `outcomes` |
| `insight_metadata` | k/v | build date, source files, record count, bytes→token ratio, plugin versions seen |

Privacy: the snapshot holds only what `sanitize()` produced; no new field class enters. The
`raw_sql` records the sink dead-letters are kept locally as `waste_class = unreplayable` (count only —
the `sql` argument is dropped by the builder).

---

## 4. The MCP on the traces — what "on the traces" means here

The ask was *an MCP on the traces*. The concept delivers one: two MCP tools whose **every answer is
computed from trace records**, hosted inside the KB server process instead of a process of their own.
From the client there is no difference — a Claude Code session or a claude.ai connector calls
`d365_prior_art` exactly as it would call a tool on a dedicated trace server, gets the trace
snapshot's freshness line and coverage lines saying what the traces do NOT include. Only the process
boundary and the URL moved. (An earlier status line "there is no MCP server on the traces" described
the packaging and was misleading about the interface; this section replaces it.)

| Tool output | Trace record it is computed from |
|---|---|
| Request matched | `open.request.key`, `open.request.interpreted` (hook stream) |
| Recipe — ordered calls with arguments | server ∪ hook call records of the cheapest run whose `close.conclusion.outcome` is `answered`, paired by argument subset |
| Cost of that run | `result.bytes`, `result.duration_ms` summed over its call records |
| Objects touched, with functional entity | `touched[]` on the server records, resolved through the vocabulary (+ `sem_mappings`) |
| Waste the run still paid | `result.kind` ∈ {empty, not-found, error}; repeated `(tool,args)`; `has_more` without a later `cursor` call; `raw_sql` (unreplayable) |
| Field usage heat (entity dossier) | `touched[]` of kind `field` across all investigations, with `functional_context` / `request_key` |
| Strategy framing each call group | `step.intent` records, by `ts` order |

The KB and Labels only attach type, label and description to fields the traces name. Without the
traces both tools return empty; without the KB the entity tool still reports usage, just without
field meaning.

**All traces, all streams.** The snapshot is built from every record in the local sink directory:
the hook stream (`open`/`step`/`annotate`/`close` + one hook-side record per KB/XRef/Labels call made
from Claude Code, stdio or connector) and the server stream of all four stdio servers (KB, XRef,
Labels, **Sec**) — pending files and `.sent` files alike. Security server records carry no
investigation id (the hook matcher excludes Sec by decision) and are kept as session-level calls; the
tools say so in a coverage line. Not in any trace and therefore not in the snapshot: Task Recorder
calls, calls served by the Azure app to connectors outside Claude Code (F4), response payloads (R0),
and the `sql` text of raw-SQL calls.

**Why hosted on the KB server.** Same code, same registration path, same contract tests. A separate
server adds a Function, deploy-list entry, connector, health check and second `tools/list` for two
tools. The move is mechanical (register `insight-tools.js` from a new entry point — one afternoon)
and the numbers hold; recommended once a third tool or a non-D365 trace source exists.

### 4.1 The two tools

Both on the KB server via `registerKbTools`, response contract in full (H2, `_Insight snapshot: …_`
banner, typed-first adaptive text, coverage lines, `notFoundResult` with suggestions, `format`,
`cursor` where a list can grow). Combined `tools/list` target was ≤ 4.5 KB; **measured 2026-09-11: +9,292 B** on the KB list (91,916 → 101,208 B) — the entity dossier's field and usage row shapes and the recipe step shape are structure, not prose, and the keys/fields arrays were already merged into one. Accepted because both tools sit outside `core`; a further diet means dropping typed keys the tools need.

**`d365_prior_art`** — *"Has this request been investigated before, and how?"*
Input: `request_key` **or** `text` (matched against `recipes.request_key` and `investigations.interpreted`
plus vocabulary aliases; top 3). Output per hit: `request_key`, runs, outcomes, best/median cost,
`recipe[]` (tool + args), objects touched with functional entity, the waste the best run still paid,
Miss → `emptyResult`, ~150 tokens.
Improves: calls per recurring investigation (efficiency), path quality.

**`d365_entity_insight`** — *"What IS `customer` here and what of it matters?"*
Input: `entity_id` or alias; `sections` (default `summary,keys,usage`; opt-in `fields`, `labels`,
`recipes`); `languages` for label text. Output: vocabulary mapping (data entities, primary tables,
key fields), confirmed `sem_mappings`, then read-through: fields from the KB (`queryTableFields`),
label + developer description from Labels, each field with `usage.investigations/calls/last_seen`
and the fields never touched on request. Default response ≤ ~1.5k tokens (the `sections` discipline
of `d365_lookup_table`). Improves: one call for the entity dossier (efficiency), key fields and
meaning from the snapshot (quality), the heat map (migration).

Not built: a metrics tool (report), a compare tool (report `group_by` + two windows), a field-usage
tool (a `sections` value of the entity tool), a raw-SQL tool, any write path.

---

## 5. Report KPIs (ClaudeTrace `analyze.js`, existing renderer)

| KPI | Definition | Class |
|---|---|---|
| Calls / est. tokens per `answered` investigation | median and p90, by `request_key`, `plugin_version`, week | efficiency |
| Waste share | `empty` + `not-found` + `error` + identical `(tool,args)` repeat + `has_more` with no later `cursor` call + `unreplayable`, over calls | efficiency |
| Exchange coverage | calls under a `step` intent ÷ calls (rule 26) | quality proxy |
| Entity hit rate | `open.expected_entities` ∩ functional entities of `touched[]` ÷ expected | quality proxy |
| Verification discipline | a `check_exists`/`preflight` on the object precedes its first assertion-bearing call | quality proxy |
| Outcome mix | `answered` / `partial` / `abandoned` | quality proxy |
| Prior-art hit rate | investigations whose first call is `d365_prior_art` with a hit ÷ investigations on a known request key | adoption |

`/report/data?group=request_key|tool|plugin_version|week&days=…` and the page's existing filters. A
before/after is two windows or two plugin versions side by side in the same table — no new endpoint.

Baseline (first build, from the 2026-09-10 read): 103 calls, 3 of 5 dossiers without strategy lines,
9 of 9 raw_sql records unreplayable. Four-week targets: −25% calls and −30% est. tokens on request
keys with prior art; waste < 15%; exchange coverage > 90%; entity hit rate > 80%; prior-art hit rate
> 50% on known keys. Replace with measured targets after four weeks.

---

## 6. OKF bundle — SKIPPED (decision 2026-09-11)

> Florian decided on 2026-09-11 to skip the bundle: the efficiency and quality gains come from the two
> tools and the report; the pages served only reuse outside the MCP stack. Kept below as the design to
> pick up if a consultant asks to review entity knowledge in git. Recommendation then: pages read-only
> generated, humans correct the mapping store.

The builder also writes `okf/` (or `$OKF_OUT`): `index.md`, `log.md`, one page per functional entity
that has usage (`type: Functional Entity`), frontmatter `title`, `description`, `resource:
/entities/<id>.md`, `tags`, `sources[]` (vocabulary, snapshot date, investigation count),
`generated: {by: build-insight/<version>, at}`, `status: draft`, `stale_after: <next weekly publish>`.
Body: D365FO data entities, primary tables, key fields, then the field table with label, developer
description and usage heat, then the request keys that touched it. Recipes get a page each
(`type: Request Recipe`) only when a human sets `verified` — until then the snapshot serves them.

Rules: **generated, never hand-copied** (rebuilt every publish; hand text lives in the rulebook);
**small** (tens to low hundreds of pages, the KB stays where it is); **same privacy scrub as the
plugin test**. Retrieve is `d365_knowledge` reading the bundle by `type`/`tags` alongside the
rulebook; store is the builder plus the existing narrow write tools — no new open-ended write path.

Value: a consultant corrects an entity page in a pull request and the correction carries a
`human:` verifier; the M3 project reads the pages without the MCP stack; never-touched fields
scope the cleansing effort before profiling starts.

---

## 7. What v1 had and v2 dropped, and the cost that bought

| Dropped | Saved | Kept the value by |
|---|---|---|
| Sixth server `d365fo-insight` | Function, connector, health check, deploy list, second `tools/list`, ~1 day + recurring | two tools on the KB server, outside `core` |
| Table Storage reader in the MCP repo | Storage auth path, PIM dependency, SDK | local sinks are complete today; `--pull` later |
| `insight_metrics`, `insight_compare`, `insight_field_usage` tools | ~7 KB `tools/list` on every session, 3 handlers + schemas + tests | report `group_by`; `sections` on the entity tool |
| `eval_joins` table and code | code for data that does not exist yet | the naming convention; the table when the first run exists |
| `counterparts` table | speculative schema | the join is `request_key` + `erp` on `investigations`; add the table with the first M3 dossier |
| OTel export | a builder task with no consumer today | listed as a later export; the contract is unchanged |

---

## 7a. Implementation status (2026-09-11)

| Item | State |
|---|---|
| `build/build-insight.js` + `npm run build:insight` (all local sinks, hook + kb/xref/labels/sec, pending + `.sent`; twin pairing; waste classes; vocabulary + `sem_mappings` resolution) | **built**, first real snapshot: 13 files · 438 records → 15 investigations · 253 calls (143 paired, 91 without dossier) · 14 recipes · 32 usage rows · 252 KB |
| `d365_prior_art`, `d365_entity_insight` on the KB server (`src/azure/insight-tools.js`), `tryGetInsightDb()`, `insight_metadata` known to the freshness reader | **built**; outside `CORE_TOOLS` |
| Tests (`test/insight-build.test.js`, `test/insight-tools.test.js`), static scans, budget ceiling re-baselined, resources tool count 34, KB instructions carry the two verbs | **green** |
| `Deploy.ps1 -Databases insight`, `Rebuild-Provenance.ps1` runs the insight build, `.env.example`, CLAUDE.md, tooling skill first-call rows + trace section | **done** (plugin 1.7.2 pending install) |
| KPIs in ClaudeTrace `analyze.js` + the report page (P2) | **built and DEPLOYED 2026-09-11** — sink v0.5.0; the model gained waste classes, exchange coverage, entity hit rate, `recipes`, `entity_usage` and `kpis` (overall + by week / request key / service / tool), the page gained the three panels, per-call waste + token + entity chips and the index columns. Grouping is computed in the model, so no `?group=` parameter was needed. Vocabulary copied to the sink by `gen:trace-ingest` |
| Azure deploy (code + `d365fo_insight.sqlite`) | **done 2026-09-11 12:05 UTC** — `Deploy.ps1 -Databases insight -SkipRoles`, 9/9 health checks, both tools verified live on `/api/d365kb` |
| `--pull` from Table Storage, eval join, counterparts, OTel export | later, as planned |

## 8. Plan and effort

| Phase | Deliverable | Effort |
|---|---|---|
| **P0** | `build/build-insight.js` from the local sinks (+ vocabulary, `sem_mappings`), §3 schema, tests on a fixture ndjson, `npm run build:insight`, first snapshot and printed baseline | 0.5 day |
| **P1** | `d365_prior_art` + `d365_entity_insight` in `src/azure/insight-tools.js`, registered from `kb-tools.js`; `tryGetInsightDb`; KB budget ceiling re-baselined; golden fixture; `Deploy.ps1 -Databases insight`; tooling-skill rule "first call on a known request key is `d365_prior_art`" + the same line in the `/d365-*` commands' first step; plugin bump | 1 day |
| **P2** | KPI set + `group_by` in ClaudeTrace `analyze.js`, `/report/data?group=`, page columns; E01 scope note | 0.5 day |
| ~~P3~~ | OKF entity pages — skipped 2026-09-11 (§6) | — |
| later | `--pull` from Table Storage when F4 is unblocked; eval join table with the first traced eval run; `counterparts` with the first M3 dossier; OTel export when a consumer exists | on demand |

Maintenance: the builder runs inside the weekly publish (seconds) and on demand; two tools follow
the same contract tests as the other 79; the report is already deployed and tested. Nothing new to
monitor.

---

## 9. Decisions needed

1. Two tools on the KB server (this concept) rather than a sixth server. Recommended.
2. E01 scope note: sink unchanged, read path via snapshot. Needs confirmation because E01 is recorded.
3. Serve Claude's own `interpreted` / conclusion text (≤200 chars) in `d365_prior_art`. Recommended yes.
4. OKF pages in the MCP repo under `okf/` versus a separate knowledge repo. Recommended: MCP repo
   first (one builder, one CI), move when a second producer appears.

---

## 10. What the first real measurement said (2026-09-11)

The report was deployed against 18 recorded investigations (249 paired calls). The numbers are the
baseline §6 asked for, and three of them are worse than the targets — which is the point of having them:

| KPI | Measured | Target (4 weeks) |
|---|---:|---:|
| Calls per answered investigation (median, prior art excluded) | 6.5 | −25% on keys with prior art |
| Waste share | **29%** | < 15% |
| Exchange coverage (calls under a strategy line) | **28%** | > 90% |
| Entity hit rate | **20%** (9 investigations declared a hypothesis) | > 80% |
| Verified before asserting | 22% | — |
| Prior-art hit rate | not yet consulted | > 50% |

Waste breaks down as 32 empty, 15 error, 13 unreplayable (raw SQL), 11 repeat, 9 unfollowed page,
3 not-found. The tool leaders by payload are `d365_effective_schema` (8 calls, 312 KB) and
`d365_get_method_source` (48 calls, 235 KB); `d365_check_field_exists` has the worst waste share (57%),
which is expected for a preflight and is the reason waste is read per tool, not globally.

Two of the low figures are capture artefacts, not behaviour: a strategy line written in the same text
block as the `Request:`/`Entities:` lines folds into the `open` record and produces no `step`, and an
entity hypothesis is only recorded when the `Entities:` line is the first text of the turn. Both are
hook-side and are the next thing to fix — before these two KPIs are used to judge anything.
