# Claude ↔ D365FO MCP communication — efficiency analysis and improvement strategies

Date 2026-09-04 · Basis: session `74182cab-34e3-4c47-aa5b-47feb51a6733` (14 turns, vendor-entity question → data-modelling levels → M3/AX 2012 → trace hooks + Azure Function build → MCP-trace design → this analysis) plus a second, independently pasted run of the same first prompt. All numbers measured from the transcript with `Get-SessionTurnStats.js` and `Get-McpCallStats.js` (this folder). Costs are indicative: 0.50 / 5 / 25 USD per MTok for cache-read / fresh input / output.

## 1. Findings

### 1.1 The first question (vendor entity) — two runs of the same prompt

| Run | MCP calls | MCP response tokens | Answer quality |
|---|---|---|---|
| This session | 11 | 25,300 | complete data-source breakdown, keys, customisation, related entities |
| Pasted run | 4 | ≈17,000 (3 lookups + 1 entity read, full JSON on the terminal) | partial: "230 fields not listed … one paged call away", data sources inferred from 71 of 301 fields |

Neither run decided the **answer shape** before the first call. Both opened with field-list tools although "logical structure" needs data sources, keys and the party link, which is one aggregate SQL (281 tokens) plus one index lookup. The two runs also differ in call plan and quality, i.e. the skill guidance leaves the plan to improvisation. Of the 25,300 MCP tokens in this session roughly 20,000 were never cited:

| Response section | Tokens | Used |
|---|---|---|
| VendTable outgoing_relations, 65 rows — **emitted twice** (second call was `custom_only`, which filters fields only) | 3,715 × 2 | ~25 names once |
| VendTable incoming_relations, 20 rows, truncated anyway — emitted twice | 892 × 2 | 0 |
| VendVendorV2Entity 60 field rows | 1,954 | 0 (breakdown came from raw SQL) |
| raw SQL dump of 119 non-VendTable fields | 3,583 | ~15 rows |
| `d365_search "vendor entity"`, 15 hits | 891 | 0 |
| DirPartyTable full lookup | 2,636 | 3 facts |

### 1.2 The client drops the compact channel

Claude Code stores an MCP tool result as the server's `structuredContent` JSON when one is provided. Verified on all 10 MCP results of this session: the stored content is the JSON byte for byte, the TOON/Markdown text channel (and with it the `_KB snapshot: date_` banner) never reaches the model or the terminal. **The adaptive TOON/Markdown optimisation in the D365FOMCP servers is currently bypassed for Claude Code clients.** The terminal noise Florian sees is that JSON.

### 1.3 The whole discussion

| Turn | Topic | API calls | Context at end | Est. USD | Observation |
|---|---|---|---|---|---|
| 1 | vendor entity | 7 | 117 k | 0.83 | 85 k fresh tokens = baseline context (~60 k: system prompt, CLAUDE.md, MEMORY.md index, tool schemas, two skills) + 25 k MCP |
| 2–8 | modelling levels, M3, AX 2012 | 1–2 each | 121 → 149 k | 0.14–0.30 each | no tools needed; visible answers 740–1,400 tokens each (≈500–1,000 words) |
| 9 | hook/Function design | 5 | 170 k | 0.73 | **topic switch, no new session offered** |
| 10 | build + deploy | 18 | 221 k | 2.93 | 3.6 M cache-read tokens: 18 calls × ~200 k context. In a fresh session (~70 k) the same work costs ≈1.3 M → ≈1.2 USD saved on this turn alone |
| 12 | MCP-trace design | 9 | 243 k | 1.52 | 1 subagent (49 k tokens) for four facts a single WebFetch would give |
| 13–14 | this analysis | 4 | 278 k | 0.94 | |
| **Total** | | **56** | **278 k** | **8.70** | output 100 k tok, cache-read 9.9 M tok, fresh 248 k tok |

Cost is dominated by **context size × number of API calls**, not by any single response. 71 % of the cost sits in turns 9–12, i.e. in the build work done on top of 150 k tokens of unrelated prior context. The CLAUDE.md rule "new topic → new session … say so" existed and was not applied by the assistant at turn 9.

Smaller items: `Wake-Lite initialized` banner on every Bash result (≈45 × 15 tokens); a classifier block on `Deploy.ps1` cost one extra cycle; the brainstorming skill text (~2.5 k) is a fixed load per build task.

## 2. Improvement strategies

Each item: **ID · owner · change · evidence · expected effect · done-when**. Ordered by payoff.

### A. Conversation practice (Florian + assistant) — zero implementation cost

**A1 · New session at every topic switch, offered by the assistant.**
Owner: assistant behaviour (rule already in CLAUDE.md; add to the tooling skill's §2 as a hard step: *"If the new prompt does not need the prior context, answer: 'This is a new topic — a fresh session will cost about half; continue here or restart?' before doing any work."*).
Evidence: §1.3, turns 9–12 = 6.1 of 8.70 USD.
Effect: −40 to −50 % on build turns.
Done-when: rule text in `d365fo-mcp-tooling/SKILL.md` §2 and in the global CLAUDE.md "Sessions" block reworded from a habit to an assistant obligation.

**A2 · Answer shape and call budget in the first sentence.**
Owner: Florian (steering) and assistant (default).
Steering examples: "summary only, no field lists", "three calls max", "answer in ten lines, details on request".
Assistant default: state the shape before the first call ("Shape: data sources + keys + party link → 1 SQL + 1 lookup"), then call.
Evidence: §1.1 — 25 k vs ≈1.5 k tokens for the same structural answer.
Effect: −70 to −80 % MCP tokens on structure questions.
Done-when: rule in tooling skill §2 ("Decide the answer shape before the first call; name it in one line").

**A3 · Layered answers for conceptual questions.**
Owner: assistant. First a 5–8 line answer, then "details?" — tables and examples only on request.
Evidence: turns 2–8, ~1 k tokens visible text each, all output-priced (25 USD/MTok).
Effect: −50 % output tokens on explain turns (≈0.05–0.10 USD each; larger effect on reading time).
Done-when: reflected in the "Writing for the user" practice; no code.

### B. Skill rules (d365fo-mcp-tooling, d365fo-mcp-workflows) — 1 hour

**B1 · Counts and aggregates before any list.** For entities: `SELECT data_source, COUNT(*) … GROUP BY` (or the new summary mode, C2) before `get_entity_sources`; for tables: indexes and relation *counts* before relation rows.
**B2 · Provenance on the first call.** When customisation is in scope pass `include_provenance: true` on the *first* `d365_lookup_table`; never a second lookup with `custom_only` on the same table (it re-emits 4.9 k tokens of relations, §1.1).
**B3 · No discovery search for a known name.** `d365_search` only when the object name is unknown; never to "see what else exists" around a known entity.
**B4 · raw_sql: aggregate, then sample.** `GROUP BY` first, then at most 5 rows per group; never a >50-row dump into context.
**B5 · Recipe for "structure of entity X".** A fixed 3-call plan in the workflows skill: (1) `get_entity_sources` summary mode / GROUP BY SQL, (2) `lookup_table <primary>` with `sections: indexes,relations_out` (C1) and `include_provenance`, (3) `data_entities` catalogue query for siblings. Target ≤ 4 k MCP tokens.
Evidence: §1.1 both runs.
Done-when: the five rules are in the skills; `/d365-table` and a new `/d365-entity` command carry a `--brief` default that executes B5.

### C. Server changes (D365FOMCP repo, Florian) — ½–1 day

**C1 · `sections` parameter on `d365_lookup_table`.** Values `fields, indexes, relations_out, relations_in`; default `fields,indexes,relations_out`; **`custom_only` implies `fields` only** unless sections is given; `relations_in` defaults to a count (`incoming_count`) not rows.
Evidence: 3,715 + 892 tokens emitted twice; incoming rows never cited.
Effect: −60 % on every table lookup; −80 % on custom_only follow-ups.

**C2 · `summary: true` on `d365_get_entity_sources`.** Returns header + `data_sources: [{name, field_count}]` + key fields + `method_count` + `custom_field_count`; ~300 tokens. Make it the default when neither `fields_like`, `custom_only`, `computed_only` nor `cursor` is given.
Evidence: 1,954 tokens of field rows, 0 used; the breakdown had to come from raw SQL.

**C3 · Compact relation rows.** `"CashDisc → CashDisc.CashDiscCode (Association)"` strings instead of nested objects; ≈⅓ of the size. Keep the object form behind `format: "json"` if a consumer needs it.

**C4 · Search results without snippets by default.** `object_type, object_name, module_id, label`; `context` only with `include_context: true`.
Evidence: 891 tokens, 0 used.

**C5 · Decide what the client actually reads (highest leverage, smallest change).** Because Claude Code stores `structuredContent` (§1.2): either (a) omit `structuredContent` on list-shaped tools so the compact text channel is what arrives, or (b) make `structuredContent` the compact form and keep the verbose object only in the text channel for humans. Verify with one call after the change by reading the transcript record. This also restores the snapshot banner to the model.
Effect: the whole TOON/Markdown investment becomes effective; terminal output shrinks accordingly.

**C6 · Server-side "shape" hints.** Every list response already carries `has_more`/`truncated`; add `hint: "for structure use summary:true"` when a list call returns >2 k tokens and no filter was passed. Cheap nudge that survives skill drift.

### D. Measurement and tracing — make this analysis automatic

**D1 · `Get-SessionTurnStats.js`** (this folder, written today) — per-turn context, output, cost; run it at the end of any expensive session.
**D2 · MCP call tracing** (design `C:\working\ClaudeTrace\docs\2026-09-04-mcp-call-tracing-design.md`, awaiting approval) records bytes, `has_more`, `truncated`, `is_error` per MCP call → the used/returned ratio and the C-items' effect become a report, not a one-off.
**D3 · KPIs and targets** (per investigation): MCP tokens per answered question ≤ 5 k; ≤ 5 MCP calls for a structure question; no response section >1 k tokens with zero citations; context at the start of build work ≤ 80 k (else new session).

### E. Small hygiene

**E1** Silence the `Wake-Lite initialized` banner for non-interactive shells (it is a local logger in the bash rc; guard it with `[[ $- == *i* ]]`).
**E2** Prefer one `WebFetch` over a subagent for a single documentation page.
**E3** When a deploy script is likely to hit the classifier, run the create/publish steps directly from the start.

## 3. What does *not* need changing

- Warm MCP latency (20–60 ms) is not a cost; cold start ~2.5 s is acceptable.
- Batching was applied (parallel independent calls); the AskUserQuestion batch of three was the right call.
- The recorded-decision memories and the design report are the right size for their purpose.

## 4. Implementation order

1. A1, A2 (today, wording only) → 2. C5 (verify what the client reads; one-line server change) → 3. C1, C2 (parameters) → 4. B1–B5 skill rules and `/d365-entity --brief` → 5. C3, C4, C6 → 6. D2 tracing → 7. E-items.

Expected result on the benchmark question: ≈4 calls, ≤ 4 k MCP tokens, same or better answer; on a build session started fresh: ≈half the cache-read volume.
