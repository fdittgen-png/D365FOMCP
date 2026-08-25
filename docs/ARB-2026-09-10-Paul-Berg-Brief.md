# Call brief — Paul Berg (Data Platform Architect), Architecture Review Board

**When:** Wed 10 Sep 2026, 09:00–10:00 CET · organiser Antoine Bastian · attendees: Antoine, Igor Pistek, Paul Berg, Reddy Narendra, Aurélien Lambert, me
**Stated agenda:** "review templates and ideas about future improvements"
**My objective:** get the D365FO MCP platform recognised by the ARB as (a) an accepted serving-layer pattern and (b) a data-platform *citizen* — with Paul as ally, not gatekeeper.
**Companion page:** MCP Serving Layer Decision — https://claude.ai/code/artifact/453875a5-3fc0-4b6c-8d09-56ee777fa3c3

---

## 1. Who I'm talking to and what he will care about

Paul owns the enterprise data platform. He will not evaluate 53 tools; he will evaluate whether this system **duplicates, bypasses or feeds** the platform. Expect questions in this order:

1. Where does the data come from, how fresh is it, who owns each source?
2. What is in it — any personal / customer / financial data?
3. Why SQLite on a Function App and not Fabric / Synapse / Databricks / Azure SQL / Dataverse?
4. How is it operated — refresh, monitoring, failure modes, cost, who else can run it?
5. Can the pattern be reused? (that is the "templates" item on the agenda)

Lead with what he cares about (lineage, classification, fit) and only then show the platform.

## 2. Facts I must have at my fingertips

### Data lineage
| DB | Source | Owner | Size | Refresh today |
|---|---|---|---|---|
| KB | AOT metadata, PackagesLocalDirectory, 180 models (MAIN roots) | me | ~1 GB | manual rebuild (~10 min, delta-merge ~1 min) |
| XRef | compiled cross-reference SQL (LocalDB on dev box) → SQLite; includes iExtension + HISOL | me | ~3.3 GB | manual rebuild + upload |
| Sec | AOT security objects + DMF export `secMCP_Repository` (user→role) | Eugene (CR 99351) / me | ~60 MB (180 MB indexed) | manual |
| Task Recorder | no DB — parses uploaded .axtr | me | — | — |

Every response carries `_<service> snapshot: <date>_` so consumers see staleness.

### Data classification
- Metadata only, **except Sec**, which holds user identities and their role/company assignments.
- No customer, vendor, transactional or financial data — by design and enforced by build scripts.
- Access: Entra tenant members only (Easy Auth + in-repo OAuth proxy for MCP clients, RFC 8707 resource-strip). Open item: non-member 403 test not yet executed.

### Hosting decision (see companion page for the matrix)
- Workload = read-only frozen snapshot, sub-second point lookups, low concurrency → serving cache, not analytical store.
- Weighted matrix: SQLite 160 · Azure SQL 150 · Fabric 135 · Synapse/Databricks 115 · Dataverse 95 (max 205).
- Position: **Fabric as system of record, SQLite as serving cache** — not "we don't need the platform".
- Known Bicep drift: EP1 vs P0v3 plan, no snapshot storage container.

### Reliability — own it before he raises it
- **Incident 2026-04:** botched upload → 0-byte XRef DB → outage. No integrity check in Deploy.ps1. *Fix planned:* checksum + staged blob swap.
- **Incident 2026-08-25:** `sec_object_access` / `sec_effective_permissions` / `sec_permission_trace` ran >90 s and wedged the server (idle-timeout after 1800 s). **Root cause found:** every `JOIN … COLLATE NOCASE` lacked a NOCASE index → 41k × 27k nested-loop scan; better-sqlite3 is synchronous so one call blocked all others. **Fixed:** 11 NOCASE indexes + static test pairing every NOCASE join with an index; 90 s → 1.1 s. Local DB re-indexed; **Azure sec DB re-upload still pending** — do this before the 10th.
- Gap: query budget (`runWithBudget`) covers raw-SQL tools only. Extend to all tools.
- No alerting; only App Insights traces + Deploy.ps1 health checks.

### Cost & ownership
- One Function App (`tis-d-mcpd365fo-func`) + storage; validate monthly figure with FinOps before the call.
- Bus factor = 1 (me) for build + deploy; Eugene for the DMF export.

## 3. What I want from Paul

1. Agreement that SQLite-as-serving-cache is an acceptable pattern **under conditions C1–C3** (Fabric publish, automated refresh with integrity gate, query budget on every tool).
2. A landing zone in Fabric for the build outputs (workspace, lakehouse, naming, pipeline ownership) — and whether Purview picks it up automatically.
3. His view on the MCP reference architecture as an ARB template (auth pattern, response contract, provenance table, deploy pattern).
4. A named backup for build/deploy from his team or IT ops.

## 4. Topics to discuss with Paul — checklist

- [ ] **Lineage & ownership** — walk the source → build → serve table; confirm who he considers the data owner for Sec (identity data).
- [ ] **Refresh cadence** — today manual; propose scheduled build; ask whether the trigger should live in Fabric pipelines or in Azure DevOps.
- [ ] **Data classification & retention** — confirm Sec user→role data classification; retention of old snapshots (none today).
- [ ] **Hosting decision** — present the matrix; ask him to challenge the weights, not the scores.
- [ ] **Fabric integration (C1)** — build outputs → lakehouse; which workspace, who owns the pipeline, Purview registration.
- [ ] **Integrity gate for deploys (C2)** — checksum + staged swap; does IT have a standard he wants reused?
- [ ] **Query governance (C3)** — NOCASE index fix shipped; budget wrapper to extend; ask about alerting standard (App Insights → ?).
- [ ] **Bicep drift** — EP1 vs P0v3, missing snapshot container; agree who fixes IaC and where it's reviewed.
- [ ] **Auth model** — Easy Auth + OAuth proxy; non-member 403 test outstanding; Copilot Studio / claude.ai client status.
- [ ] **Cost** — monthly run cost, compared with the Fabric capacity he would have to provision instead.
- [ ] **Reference template for the ARB** — MCP server pattern (identity metadata, response contract, structured output, deploy) as a reusable template; align with the "templates" agenda item.
- [ ] **Operational ownership / bus factor** — who else can build and deploy; runbook location (`docs/`).
- [ ] **Reopen triggers** — >10 GB, sustained high query volume, second consuming system, need to join with other enterprise data.
- [ ] **Related initiative** — M3 Clermont-Ferrand migration bridge uses the same snapshot principle; ask if the platform team wants to be involved early.

## 5. Before the call — to-do

- [ ] Re-upload the re-indexed Sec DB to Azure (or run `node build/add-sec-indexes.js` there) and re-run the three hanging tool calls against the live endpoint.
- [ ] Get the monthly Azure cost for the resource group from Cost Management.
- [ ] Run the non-member 403 test on the OAuth path.
- [ ] Push commit 438b054 and the uncommitted FTS/OAuth work so the repo matches what is live.
- [ ] Share the companion page with Paul the day before.

## 6. Do not spend time on
Tool-by-tool demos, X++ specifics, SoD history, TOON encoding details — those are for functional stakeholders.
