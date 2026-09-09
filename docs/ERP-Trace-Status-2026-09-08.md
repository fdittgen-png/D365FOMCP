# ERP Trace Module — Status and Next Actions (2026-09-08, end of day)

Companion to `ERP-Trace-Ingest-Concept-2026-09-08.md` (design + expectations register E01–E45) and
`ERP-Trace-Capture-Implementation-2026-09-07.md` (the capture side). This page is the one to read first
when resuming: what runs where, what was proven, what is left and who owns it.

## 1. One-paragraph status

The trace pipeline is **live end to end**. Every D365 KB / XRef call made from Claude Code is captured by the
plugin hook (plugin **1.5.0**, installed) as an investigation dossier — `open` (the request as Claude declared
it), `step` lines, one call record per MCP call with replayable arguments, an `annotate` record from `Entity:` /
`Expect:` lines, and `close` — and posted to the message sink `tis-d-claudetrace-func` (**v0.2.0**), which
re-validates each record (schema + privacy), archives it as NDJSON in blob, indexes it in Table Storage by
investigation and by request key, and dead-letters rejects without their body. The sink reaches its storage
through its **managed identity** (phase 2, deployed today). Bearer authentication for the Azure MCP apps
(phase 3) is built on both sides and waits for one Entra-admin action.

## 2. What runs where

| Component | Location | Version / state | Verified today |
|---|---|---|---|
| Plugin hook `trace-capture.mjs` | `plugin/d365fo-mcp/hooks/` (MCP repo), installed from the local marketplace | **1.5.0** — annotate emitter, protocol lines as FIRST text, 207 handling | 16 hook tests; live records in `hook.ndjson` and in the sink |
| Server-side `withTrace` | `src/trace/client/` (MCP repo), on the three stdio servers by default | file sink `~/.claude/mcp-trace/<service>.ndjson`; http sink with function key **or** managed-identity bearer (`identityTokenProvider`) | `xref.ndjson` record correlated to the hook's investigation id |
| Contract | `src/trace/contract/` (MCP repo) — copies generated into the hook (`gen:trace-hook`) and the sink (`gen:trace-ingest`, `CONTRACT.sha256`) | v1.0.0; `sanitize()` keeps `expects` on annotate; `validate.js` names the offending key | drift tests on both sides |
| Message sink | `C:\working\ClaudeTrace` → `github.com/fdittgen-png/ClaudeTrace` (private, `main`) | **v0.3.0** (2026-09-09: concept §8 metrics + alert rules), 63 tests | health 200 at 0.3.0, smoke `received=0 accepted=0`, 15 records / 3 dossiers / 3 request keys, 0 dead letters; alert rules `…-deadletter-rate`, `…-silent-outage` + action group deployed |
| Store | storage account `tisdclaudetracest`: blob `trace-landing`, `trace-deadletter`; tables `tracerecords`, `tracerequests` | declared in Bicep; identity path (`TRACE_STORAGE_ACCOUNT`), Blob + Table Data Contributor on the Function MI; 30-d dead-letter lifecycle; €5 budget | `Reingest-Landing.ps1` through the identity path: 4 accepted, tables idempotent |
| Local tooling | `scripts/Push-LocalTraces.ps1` (MCP), `scripts/Get-TraceStats.ps1`, `scripts/Reingest-Landing.ps1` (ClaudeTrace) | | all three run today |
| Azure MCP apps (`tis-d-mcpd365fo-func`) | trace **off** (`MCP_TRACE` unset) | phase 3 settings documented, not applied | — |

Merged today on `D365FOMCP/main`: PR **#138** (sink client side, concept), **#139** (annotate emitter, protocol,
plugin 1.5.0), **#140** (managed-identity bearer), **#141** (register). ClaudeTrace: 8 commits, all pushed.

## 3. Decisions taken today (do not re-open without a new fact)

1. **No Cosmos DB.** Blob landing zone (the truth, no TTL) + two Table Storage indexes (the two R0 read shapes)
   in the Function's own account. Reason: the 2026-09-04 scope decision moved the analysis out; what remains is
   exact-key lookups and a scan. Re-ingestion from the landing zone makes any later store change free.
2. **Function key stays for the hook**; managed-identity bearer only for server-to-server.
3. **A server-side privacy hit is dead-lettered, never masked and kept** — everything maskable is already masked
   by the shared sanitizer, so what remains is unmaskable party data = a producer defect.
4. **Unknown keys are schema dead letters naming the key** (strict contract).
5. **`queue` sink dropped** (E27 deviated): the http sink with a bearer covers the Azure apps.
6. **Push script first** for the stdio file sinks; `TRACE_SINK=http` on stdio re-evaluated after two weeks.
7. **No immutability policy, no stats endpoint** (a script reads storage instead).

## 4. Facts learned today (worth remembering)

- **Transcript persistence gap:** a mid-turn assistant text block carrying the `Request:`/`Entities:` lines was never
  written to the transcript by Claude Code (an empty `thinking` record sits where it belongs; every other text of
  that turn survived). The hook cannot read what is not there → the protocol requires the two lines as the **first
  text of the reply**. Not a hook defect (register E20).
- **A managed identity cannot be a token audience** (AADSTS100040, probed) and this account **cannot register
  applications** ("Directory permission is needed"). Phase 3's audience must be an admin-created app registration.
- **PIM:** `AuthorizationFailed` on the MCP resource group means the eligible `Owner` role is not active; a second
  `az login` changes nothing. Self-activation through the API is blocked for the agent (classifier) — the operator
  activates in the portal, then `az login`.
- **PowerShell → az inline JSON loses its quotes** (`-p additionalTags={...}` → "Failed to parse string as JSON");
  object/array parameters go through a merged temporary parameter file. An empty `--prefix` makes
  `az storage blob list` print its help.
- **autocrlf:** generated copies are hashed and written as LF; JSON comparisons in tests normalise line endings.
- The two retired v0.1 hooks were **still registered** in `settings.json` on the morning of 2026-09-08 and posting
  raw prompts to the stub; removed (backups `settings.json.bak-20260908`, `-20260908b`).

## 4b. Added 2026-09-09

- **Concept §8 observability shipped** (the one phase-1 item that had been left out): four custom metrics per batch and the
  two alert rules, ClaudeTrace v0.3.0, `Deploy.ps1 -AlertsOnly` for the rules alone. Platform facts recorded in the concept:
  log-alert lookback ≤ 48 h (the 7-day silence check became two working days, Wed–Fri), and a rule evaluated less often
  than every 12 h must have `autoMitigate: false`.
  Metric arrival verified in `customMetrics` (08:14 UTC batch → three entries 22 s later); alert rules listed in the RG.
- Everything else in the sink (phases 1–3 code, identity store path, re-ingestion, bearer auth) was already built and
  deployed on 2026-09-08; the remaining sink work is the Entra-gated cut-over (F2–F4) and the deferred items C2–C7.

## 5. Next actions

### Florian (operator)

| # | Action | Why | How |
|---|---|---|---|
| F1 | **Start a new Claude Code session** | plugin 1.5.0 hooks and skills load at session start; this session still runs the 1.4.x protocol text | close and reopen |
| F2 | **Ask an Entra admin** to create app registration `tis-d-claudetrace-api`, identifier URI `api://tis-d-claudetrace-api`, sign-in audience "this organisation only", **no** API permissions, **no** app roles, no secret | the token audience for phase 3; nothing else can serve (see §4) | admin task; send them this row |
| F3 | After F2: set the audience and redeploy the sink | activates bearer validation | in `C:\working\ClaudeTrace\infra\dev.parameters.json` set `traceTokenAudience` to `api://tis-d-claudetrace-api`; `pwsh -File .\Deploy.ps1` (PIM Owner active) |
| F4 | After F3: turn tracing on for the Azure MCP app | Stream 1 for connector calls | `az functionapp config appsettings set -g tis-d-mcpd365fo-rg -n tis-d-mcpd365fo-func --settings MCP_TRACE=on TRACE_SINK=http TRACE_INGEST_URL=https://tis-d-claudetrace-func.azurewebsites.net/trace/ingest TRACE_INGEST_SCOPE=api://tis-d-claudetrace-api/.default` — then one connector call and `npm run stats` in ClaudeTrace should show `source_app_id = app:6d31fb59-…` |
| F5 | Weekly, or after a long local session: push the stdio file sinks | server-side records otherwise stay on the machine | `pwsh -File C:\working\MCP\scripts\Push-LocalTraces.ps1` |
| F6 | Decide after two weeks: keep the push script or set `TRACE_SINK=http` on the stdio servers | decision 6 | `~/.claude.json` env of the three stdio entries |

### Claude (next session, in this order)

| # | Action | Trigger |
|---|---|---|
| C1 | Verify the 1.5.0 hooks from the plugin cache: one D365 call, then check `hook.ndjson` has `open.request.source = declared` and the `annotate` record when `Entity:` lines were written | first session after F1 |
| C2 | Measure connector-side correlation (`session_key` only) once F4 is live; decide on the `investigation_id` parameter injection (TDD §11.3, register E15) — measure `tools/list` growth first | after F4 |
| C3 | `REQUIRE_AUTH=bearer` cut-over needs every producer on a bearer or a second key path for the hook — design note before touching it | after C2 |
| C4 | `process[]` / `lifecycle[]` line grammar for `annotate` (register E22 remainder) | when a real analysis needs them |
| C5 | `trace_investigation` tool for claude.ai (register E23) — only if connector sessions need Stream 2 | on demand |
| C6 | Conformance kit for the next emitter (E44) — seed from the shared test corpus | when the M3 bridge starts |
| C7 | Per-person named function keys (`az functionapp keys set --key-name hook-<initials>`) when a second developer joins the pilot | on demand |

## 6. Register snapshot (from the concept, Part B)

45 expectations: **30 met · 4 partly · 4 open · 6 deviated · 1 expected**. Open = E15 (parameter injection),
E23 (claude.ai tool), E28 (tracing on the Azure MCP apps — code and settings ready, waits for F2–F4),
E44 (conformance kit). Deviations are all recorded with their reason; none is silent.

## 7. Where to look

| Question | Place |
|---|---|
| Is the sink alive and full? | `cd C:\working\ClaudeTrace; npm run stats` |
| What did a session record? | `~/.claude/mcp-trace/hook.ndjson`, `<service>.ndjson`; errors in `~/.claude/claude-trace.log` |
| One dossier | `tracerecords`, PartitionKey = `inv-<prompt_id>`, ordered by RowKey (`<ts>|<id>`) |
| All runs of one request | `tracerequests`, PartitionKey = `request.key` |
| Rejected records | blob `trace-deadletter/<erp>/<month>/<day>.ndjson` — id, reason, field, hash only |
| Design, decisions, register | `docs/ERP-Trace-Ingest-Concept-2026-09-08.md` |
| Capture side | `docs/ERP-Trace-Capture-Implementation-2026-09-07.md`, TDDs (with the 2026-09-08 amendment note in §7.3) |
| Sink internals | `C:\working\ClaudeTrace\README.md` |
