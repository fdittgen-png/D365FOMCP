# Cross-ERP Trace Module — Concept and Build Request for Fable 5.1

> **How to use this document:** this entire file is the prompt to hand to a Fable 5.1
> session. Section 1 is context Fable must inherit and never re-litigate. Section 2 is
> the business concept Fable's design must serve. Section 3 is the binding technical
> spec. Section 4 is what Fable must deliver, in order, with an explicit human
> checkpoint between design and implementation. Do not skip straight to code.

## 0. Decisions already made (do not re-ask)

| Decision | Answer |
|---|---|
| Trace store engine | **Cosmos DB** (schema-flexible, concurrent-write, append-heavy) |
| D365FO MCP (KB/XRef/Sec/TaskRecorder) instrumented from day one? | **Yes** |
| Repo / package placement | **Fable proposes it** in the TDD, against the criteria in §3.6 |
| Deliverable shape | **Technical Design Document first, then implementation** — pause for human review between them (§4) |
| Project scope (decided 2026-09-04) | **Only** the capture of valuable traces about an ERP's logical and physical data structure and about the processes Claude analysed from the user's input. Flow: User → Claude (logs the request and its conclusion) → MCP (logs the structural facts complementing each information request). Exploiting the logs is a **different project**, not this one. |
| Governing requirement (decided 2026-09-04) | **Reproducibility.** The same request must be runnable against another ERP and yield a dossier comparable with the first, containing everything Claude needs to state how the ERPs differ and how they might map for a migration: physical structure (field names, types, relations, cardinality, formatting …), logical structure, entities (logical, and the physical realisation — AOT entities in D365FO), data lifecycle, and the process that drives that lifecycle. Realised as `request.key`/`request.interpreted`/`approach` on `open`, `step` (Claude's strategy lines), **replayable call records** (tool + arguments, never the response — results are re-derived by replaying against the snapshot; second decision of 2026-09-04), and `process`/`lifecycle` on Stream 2 — TDD v1.3 §1.0. In Claude Code the dossier is captured by plugin hooks from the transcript; `trace_investigation` is the claude.ai fallback. |

---

## 1. Context Fable must inherit

### 1.1 What this repo already is
`C:\working\MCP` is the D365FO MCP platform: 4 Azure-Functions-hosted MCP servers
(KB, XRef, Security, Task Recorder) exposing D365 Finance & Operations metadata to
Claude. It has mature, enforced engineering conventions — ES modules, Zod validation,
Node's built-in test runner, a strict response-format contract with static-scan tests,
per-tool freshness banners, tool-list budget tests, and a "guardrails are opt-in at the
entry point, never defaulted on in the library" rule. **D365FO's own AOT (Application
Object Tree) technical entities — its tables, fields, relations — are the reference
technical-entity model this whole initiative maps everything else against.** Any new
module Fable builds should read and match this repo's conventions in spirit even if it
ends up living in a different repository (§3.6), because this repo is the reference
implementation other ERP MCP services are expected to align with.

### 1.2 The sibling project this generalizes
A live project (Infor M3, Clermont-Ferrand site, business owner Juliane Millot) already
established the pattern this module generalizes:

- **Claude is a builder, not a daily interface.** Dashboards/reports run as deterministic,
  AI-free artifacts refreshed on a schedule; interactive Claude use is the exception
  (deep dives, what-ifs, building the next report).
- **Snapshot principle.** No ad-hoc live queries against the source ERP from the AI
  channel; scheduled extraction jobs write read-only snapshots, and every answer carries
  an as-of date.
- **Two-level data quality**, which this module now formalizes and generalizes:
  - *Level A — tool telemetry*: which tool touched which object. Previously scoped as
    "never user content." This module **extends** that scope (§3.3) to include Claude's
    investigation reasoning, still under the hard rule that no literal business data
    value ever appears in a trace (§1.3).
  - *Level B — profiling*, culminating in `dq_target_readiness`: validating source-ERP
    data against the D365 target entity schema (mandatory fields, enum/UoM mappings, key
    uniqueness) — a DMF-staging dry run. This module's traces are what let a *future*
    analysis project derive that kind of rule generically, for any source ERP, instead of
    hand-writing it per project.
- **Migration vehicle is DMF or Connectivity Studio**, with the MCP layer as the
  intelligence in front (mapping proposals, validation-error explanation, gap reports).
  This module is the data-collection substrate that makes those mapping proposals
  possible in the first place.

### 1.3 Non-negotiable privacy constraint
Global policy: no real consumer/vendor data (named accounts, transaction records tied to
real external parties, personal contact details, VAT/bank/contract identifiers, bulk
exports) may enter AI session context, ever. **This module inherits that rule
absolutely.** A trace — from either stream — may only ever contain structural/metadata
facts (object names, field names, types, cardinalities, aggregate counts, DQ statistics)
and reasoning *about* structure. It must never contain a literal row value, a personal
identifier, or free text a user typed that could carry business data. This is a design
constraint on the schema and the logging contract, not a runtime filter to bolt on
later — Fable's TDD must state the specific enforcement mechanism (§3.4).

---

## 2. General concept — what this module is for

### 2.1 The problem
Trelleborg runs D365 Finance & Operations as its converging ERP, but sites still run
legacy, site-specific ERPs (Infor M3 today; others may follow) that will eventually
migrate. Every such migration needs the same two things, done in order:

1. **Understand how the legacy ERP's data maps to D365FO** — which source tables/fields,
   under which business rules, correspond to which functional business concepts, and
   which D365FO technical (AOT) entities realize those concepts.
2. **Execute the migration** by turning that mapping into a technical source→target
   field mapping and running it through DMF or Connectivity Studio.

Today, step 1 is manual, ad-hoc, and undocumented — a consultant or key user
investigates a legacy table, forms a belief about what it means, and that belief lives
only in their head or a one-off spreadsheet. It is redone from scratch for every
question, every site, every consultant.

### 2.2 What this module changes
Every ERP MCP service (D365FO's own KB/XRef/Sec/TaskRecorder, M3's bridge services, and
future ones) **traces** two things as a byproduct of normal use:

- **What the MCP actually returned** — the data structures, fields, types, relations,
  and data-quality-relevant facts a tool call surfaced. Captured automatically,
  server-side, on every tool call. Claude never sees or calls this path.
- **What Claude was asked to investigate, and what it concluded** — when Claude is
  building a dashboard, report, or answering an investigation, it logs the ask, (usefully)
  which underlying tool calls it made to answer it, and its conclusion. One narrow,
  explicit tool call.

Neither stream classifies anything at write time. A trace is a raw observation: "table
X, field Y, type Z, D365FO doesn't currently know this" or "Claude investigated table X
and concluded it represents projected stock." **Whether that constitutes a known mapping,
a fuzzy/candidate correlation, or an unknown, is entirely a downstream analysis question**
(separate project, out of scope here) that runs against the accumulated trace history —
never computed inline while a trace is written.

Over time and across many investigations, the trace store becomes a growing, queryable
record of: which source tables/fields have been seen, what shape they actually have
(type, range, format, null patterns), what relations/integrity they respect, what
anti-patterns they exhibit (what NOT to expect from this field), and which functional and
technical entities they have been associated with — by the MCP mechanically, and by
Claude through reasoning. Including D365FO's own MCP in this from day one means D365FO's
AOT structure — the reference technical-entity side of every mapping — is already
populated in the same trace store before a single legacy-ERP trace needs matching
against it.

### 2.3 Who benefits, and how

- **Migration (the primary objective).** A downstream analysis project (separate,
  described only for context) mines the trace history to build a common-data-layer view
  — functional entity → 1..N technical entities, per ERP — and to flag known / candidate
  / unknown correlations for a human to confirm. Once confirmed, that mapping becomes
  the literal source-to-technical-entity mapping fed into DMF or Connectivity Studio.
  The trace module doesn't do the migration; it produces the evidence the migration
  mapping is built from.
- **ERP functional responsibles / key users** (e.g. Juliane Millot's role at
  Clermont-Ferrand) get better dashboards, reports, and small performance-tracking apps
  *faster*, because every investigation Claude does leaves a trace another investigation
  can build on instead of re-discovering the same table from zero.
- **D365FO consultants (functional and technical)** get a growing, structured record of
  what a legacy ERP's tables and business rules actually mean in practice — accumulated
  from real investigations across sites and time — instead of having to reverse-engineer
  an unfamiliar legacy system's metadata cold every time a migration project starts.
- **Data-quality rule authors** get, for each observed table/field, evidence of what
  "correct" looks like in that ERP: type, plausible ranges, formatting, referential
  relations that must hold, and explicit anti-patterns (values/shapes that occur but are
  wrong). That evidence is exactly the input a later analysis pass needs to write
  `dq_completeness` / `dq_orphans` / `dq_duplicates` / `dq_target_readiness`-style rules
  and SQL for a *new* ERP without starting the profiling exercise from scratch.

### 2.4 What this module deliberately is not
- Not the analysis engine. It does not classify mappings, score data quality, or
  generate migration mappings. It only produces the trace record those processes
  consume. (Separate project.)
- Not a way for the LLM to query or browse the trace store. Claude gets exactly one
  narrow write path (§3.3); reading/analyzing traces is a human/analysis-project
  concern, never an LLM-exposed MCP tool.
- Not a change to how any ERP MCP sources its own data (D365FO's build-time snapshot
  pattern, M3's scheduled-extraction snapshot pattern) — this module observes what
  those services already do and return; it does not add a new path to the source ERP.

---

## 3. Binding technical requirements

### 3.1 Entity model
- **Technical entity**: an ERP-specific, physical/structural object — for D365FO, an AOT
  table/field/relation/enum. D365FO's technical-entity set is the reference target for
  every mapping; other ERPs' technical entities (M3 tables, etc.) are ERP-specific and
  are not assumed to resemble D365FO's shape.
- **Functional entity**: an ERP-agnostic business concept (e.g. "Customer," "Sales
  Order," "Retention Zone Stock"). A functional entity is realized by **one or more**
  technical entities per ERP, and that realization may be complete or may need
  additional fields to be complete — this varies per entity and per ERP and is not
  something the trace schema needs to model as a fixed rule; it only needs to be
  *observable* from what gets traced.
- The trace schema stores **observations that reference these entities by name**
  (ERP id + technical entity name; functional entity name where known to the caller). It
  does **not** store a computed confidence/status for the mapping — see §2.2.

### 3.2 Stream 1 — MCP-authored traces (automatic, not LLM-visible)
Every tool call on every instrumented MCP server (all 4 D365FO services from day one,
plus M3's bridge services and any future ERP MCP) is wrapped server-side — the same
architectural idea as this repo's existing `withFreshnessBanner` wrapper — to emit a
trace record of what the call *returned*, structurally: which technical entities/fields
were touched, their declared types, relevant DQ-observable facts already visible in the
response (e.g. "12% of rows had a null in field X" if the tool already computes that),
and provenance (see §3.4). **This must never add material latency or become a point of
failure for the tool response** — writing a trace is fire-and-forget / best-effort
relative to the MCP response the user is waiting on, mirroring this codebase's existing
rule that one slow path must never block every other endpoint.

### 3.3 Stream 2 — Claude-authored traces (one explicit, narrow tool)
Each ERP MCP server exposes exactly one additional tool, not a general trace CRUD/query
surface, for Claude to log an investigation. It must capture at least:
- the investigation context: what Claude was asked to investigate/build, and for what
  purpose (e.g. "dashboard: projected pallet stock on rétention");
- optionally, which underlying tool calls (tool name + target object — not full result
  payloads) Claude made while investigating, correlated to the MCP-authored traces those
  calls produced (§3.5 correlation id);
- Claude's conclusion — what it determined about the data/entities involved.

This tool is the **only** LLM-visible surface onto the trace module. There must be no
other trace-store tool reachable by an LLM (no read/query/list tool) — that boundary is
what "the MCP-to-trace interface must not be exposed to the LLM" means, and it must be
enforced structurally (e.g. the trace-store client library used for Stream 1 is not the
same package/import surface registered as an MCP tool), not just by convention.

### 3.4 Provenance and privacy enforcement
Every trace record, both streams, carries: ERP system identifier, ERP version/build, MCP
service name and version, trace stream (`mcp` / `claude`), timestamp, and a correlation
id (§3.5). Fable's TDD must specify **one explicit choke point** (a single function/module
every trace write passes through, mirroring the pseudonymization choke point already used
in the M3 project) that enforces §1.3 — structural facts and reasoning-about-structure
only, never a literal data value or personal identifier — and must state how that
enforcement is tested, not just documented.

### 3.5 Correlation
Claude's multiple tool calls during one investigation, and the MCP-authored traces those
calls produce, must be linkable to the single Claude-authored conclusion trace they fed.
Fable's TDD must propose a correlation id scheme (session/investigation id) and state
where it is minted and how it flows through both streams.

### 3.6 Contract and coupling
The schema, the logging rules, and both trace APIs (the internal Stream-1 client and the
Stream-2 MCP tool contract) must be **identical** across every ERP MCP service and
defined **once**, in a module every ERP MCP consumes without a hard/tight code
dependency on each other's internals — "loosely coupled" means: a versioned, published
contract (schema + client) that any ERP MCP repo can adopt, not a shared runtime process
or a direct import of another service's code. Fable must propose, in the TDD, **where
this module lives** (new standalone repo vs. a package inside `C:\working\MCP`) and
justify the choice against these criteria:
- independently versionable and deployable (Azure Functions, matching how the existing
  4 D365FO MCP servers are hosted, per the existing `local-deploy/`/Bicep pattern in this
  repo);
- consumable by this repo (all 4 D365FO MCP servers) and by the M3 bridge MCP (a separate
  codebase) without either depending on the other's internals;
- versioned contract with an explicit migration/compatibility story, since every consumer
  must eventually track schema changes together.

### 3.7 Hosting and cost
The trace API is exposed via Azure Functions, matching the hosting pattern already used
for the 4 D365FO MCP services. **Provisioning Cosmos DB is a new, costed, hard-to-reverse
Azure resource** — the TDD must include an explicit throughput/RU budget proposal,
partition-key design (Fable's choice, justified — likely partitioned by ERP system and/or
date given append-heavy write patterns), and a retention/TTL policy, given this
organization's stated discipline around token/infrastructure cost. **Fable must not run
any `az` provisioning or deployment command itself** — that step is human-gated in this
organization's workflow (Conditional Access / PIM), same as every other Azure change in
this project.

---

## 4. What Fable must deliver, in order

1. **Technical Design Document** (markdown, styled like this repo's existing concept
   docs, e.g. `docs/Sec-Service-Completeness-Concept.md` / `docs/Design-D365Sec-MCP-Service.md`):
   entity model, the two trace-stream schemas (concrete JSON shapes), the Cosmos DB
   container/partition/retention design, the contract/versioning mechanism, the
   repo/package placement decision and rationale (§3.6), the privacy choke point design
   (§3.4) and how it's tested, the correlation-id scheme (§3.5), the non-blocking-write
   design (§3.2), and how this integrates into each of the 4 existing D365FO MCP servers
   plus the pattern a future ERP MCP (e.g. M3's) would follow to adopt it.
2. **STOP for human review** of the TDD before writing any implementation code or
   running any Azure provisioning command. This is a deliberate checkpoint, not a
   formality — Cosmos DB provisioning and the repo-placement choice are both
   consequential and should be confirmed before implementation work begins.
3. Only after that review is approved: **implementation**, following this repo's
   engineering conventions (ES modules, Zod validation, Node's built-in test runner,
   static-scan-enforced contracts where applicable, a response/contract doc analogous to
   `docs/Response-Format-Contract.md`), including the wrapper integration into the 4
   existing D365FO MCP servers.

Do not produce implementation code before step 2's checkpoint has been explicitly
confirmed by a human.
