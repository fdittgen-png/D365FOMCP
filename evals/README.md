# MCP evals (W6.3, issue #110)

Ten questions per service in the [mcp-builder evaluation format](https://github.com/anthropics/skills/tree/main/skills/mcp-builder)
— `<evaluation><qa_pair><question/><answer/></qa_pair>…</evaluation>` — plus, per service,
the recorded tool calls that produce each answer and a token-discipline budget.

| Service | Questions | Calls (machine) | Budget | Answers (human) |
|---|---|---|---|---|
| KB | `kb.xml` | `kb.calls.json` | `kb.budget.json` | `kb.answers.md` |
| XRef | `xref.xml` | `xref.calls.json` | `xref.budget.json` | `xref.answers.md` |
| Sec | `sec.xml` | `sec.calls.json` | `sec.budget.json` | `sec.answers.md` |
| Task Recorder | `taskrecorder.xml` | `taskrecorder.calls.json` | `taskrecorder.budget.json` | `taskrecorder.answers.md` |

Design rules (from the mcp-builder guide, applied here):

- **Read-only, independent, idempotent.** Every recorded call is a tool annotated
  `readOnlyHint:true`; the local servers open their databases read-only. The Task Recorder
  set uses `taskrecorder_to_markdown` only — `taskrecorder_to_document` writes an `.mhtml`
  to disk even with `return_inline`.
- **At least two tool calls per question**, and answers that need a hop: the value of an
  enum behind a field, the EDT of a relation's target, the module of a CoC class and that
  module's dependency count. Batching counts as one call.
- **Single verifiable answer**, compared by exact string match. Where the answer has two
  parts the question fixes the format (`a,b`, no spaces; `True`/`False`).
- **Structural facts**, so the answers survive a snapshot rebuild on the same application
  version: field → enum, join keys, class hierarchy, duty → privilege → entry point, the
  checked-in `.axtr` fixtures. Counts appear only where they are structural (relations,
  direct subclasses, privileges of a duty) and every expr checks the tool's `truncated`
  flag before trusting one. Custom-layer objects (`TBG_*`, `TOC_*`, `iExtension`) never
  carry an answer.
- **Privacy.** No user, no e-mail, no party data. Sec questions are about roles, duties,
  privileges and entry points; `test/evals-format.test.js` fails if a user-centred tool is
  ever recorded.

## The verifier — `npm run evals`

```
npm run evals -- kb            # one service
npm run evals -- all           # all four, exit 1 on any mismatch or budget breach
node scripts/run-evals.mjs call kb d365_get_enum '{"enum_name":"SalesStatus"}' --expr "r[0].value_count"
node scripts/run-evals.mjs batch xref my-calls.json      # [{tool, arguments, expr?, max?}]
node scripts/run-evals.mjs list sec                       # tool names + input keys
```

`scripts/run-evals.mjs` is **not** an LLM harness. It launches the local stdio server of
the service (`src/local/mcp-server-<svc>.js`, the databases at their default
`~/.claude/d365fo_*.sqlite` paths or `KB_DB_PATH` / `XREF_DB_PATH` / `SEC_DB_PATH`),
replays each pair's recorded calls, evaluates the pair's `expr` over the returned
`structuredContent` and compares the result to the `<answer>` verbatim. It also sums the
`structuredContent` bytes of the calls and, for the budgeted pairs, checks the tool
sequence and the ceiling. What it tells you:

- **an answer stopped matching** — the snapshot changed (a rebuild on a new application
  version, a custom model added) or a tool's payload shape changed. Re-verify the fact with
  `call`, then update the XML **and** `answers.md` together;
- **a budget breach** — a tool started returning more for the same arguments. That is a
  regression in the response-shaping work, not in the eval;
- the per-question `sc bytes` / `text` columns — the two channels of rule #5, measured on
  real data on every run.

`MCP_TOOL_GUARDS=off` is set for the replay so a repeated call is not swapped for the
loop-detection note.

### Budget semantics

`<svc>.budget.json` covers three questions per service. Each entry names the **lever** the
budget rewards (`limit:1` where the count key is exact, `fields_like`, a `modules` filter, a
batch call, `get_method_source` instead of `include_source`), the expected tool sequence,
the measured `structuredContent` bytes and the ceiling (measured × 1.5). Evals measure
**discipline** — filters, limits, batching — not tool choice; the same fact fetched through a
wide dump would still be a correct answer and a failed budget.

## Plugging an LLM in later

The XML files are exactly what the mcp-builder harness consumes. With the skill's scripts
installed (`~/.claude/skills/mcp-builder/scripts/evaluation.py`, deps `anthropic mcp`):

```
export ANTHROPIC_API_KEY=…
python ~/.claude/skills/mcp-builder/scripts/evaluation.py \
  -t stdio -c node -a src/local/mcp-server-kb.js \
  -m claude-sonnet-4-5 -o evals/report-kb.md evals/kb.xml
```

The harness gives the model the question and the server's tools, nothing else, and grades
the final answer by string comparison — so the report's per-task tool-call list is the
discipline measurement, and `budget.json` is the yardstick to hold it against. Three
caveats before reading a result as a tool-quality signal:

1. **Task Recorder questions name fixture paths.** The harness passes only the question
   text, so the model must be able to read `test/fixtures/*.axtr` (a file tool alongside the
   MCP server, or the base64 pre-loaded into the prompt). Without that, all ten fail for a
   reason unrelated to the server.
2. **Sec role names are display names** (`Accounts receivable manager`, not
   `AccountsReceivableClerk`). A model that guesses the AOT form gets *not found* and must
   recover through `sec_search {object_type:role}` — that recovery is part of what the eval
   measures.
3. **`result_count` is the returned count on the XRef list tools.** A count question is only
   right with `limit` above the total and `truncated:false`; a model that reads
   `result_count` at the default limit answers wrong. Again by design.

`--model` on `scripts/run-evals.mjs` is reserved for a future in-repo runner and today
prints a pointer to this section.

## Adding or changing a question

1. Find the fact with `call`/`batch` (small `limit`, `--expr` projections — never dump a
   payload you do not need).
2. Add the `<qa_pair>` to the XML **and** the entry to `calls.json` (same index), with an
   `expr` that derives the answer from the payloads and guards the tool's `truncated` flag
   where a count is involved.
3. Record the calls and the answer in `answers.md`; if the question exercises a discipline
   lever, add it to `budget.json` with the measured bytes.
4. `npm run evals -- <svc>` green, then `npm test` (`test/evals-format.test.js` checks
   the shape: 10 pairs, registered tool names, ≥3 budgets, no e-mail, no user tool).
