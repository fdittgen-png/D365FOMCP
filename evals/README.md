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

### Without a snapshot

The KB/XRef/Sec `.sqlite` files are not in the repo. When a service's snapshot is absent at
the path its local server would open (`KB_DB_PATH` / `XREF_DB_PATH` / `~/.claude/d365fo_*.sqlite`;
Sec takes only the default path), the runner prints `skipped: no snapshot (<path>)` for that
service and exits 0. Task Recorder has no database and always runs. That is what happens in
CI (`.github/workflows/evals.yml`, job `replay`); the eval-file contract and the harness
unit tests run there unconditionally.

## The LLM leg — `npm run evals -- <svc> --llm` (issue #119)

```
npm run evals -- kb --llm                                  # claude-sonnet-5, 12 turns max
npm run evals -- all --llm --model claude-opus-5 --max-turns 8
npm run evals -- kb --llm --questions 1,2,3                # a subset
npm run evals -- kb --llm --compare auto                   # exit 2 on regression vs newest evals/results/kb-*.json
npm run evals -- kb --compare evals/results/kb-2026-09-02.json   # replay bytes vs a committed LLM run
```

Needs `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN` / an `ant auth login` profile — the SDK
client is constructed with no arguments) **and** the snapshot. For each `<qa_pair>` the model
gets exactly three things: the server's `instructions` from `src/azure/server-metadata.js`
plus one line `Answer with the value only.` as the system prompt, the tool list of the same
local stdio server the replay uses (`client.listTools()` → Anthropic `tools`, minus any tool
annotated `readOnlyHint:false` — the KB's semantic-mapping write tools), and the question.
The tool-use loop (`scripts/evals/llm-runner.mjs`) forwards every call to the server and
feeds back the **text channel** (`content[].text`, what a text-only client reads), while
recording `structuredContent` bytes (what the claude.ai connector bills). A tool `isError`
goes back as `is_error:true` — recovering from *not found* is part of the measurement — and
never aborts the question. Concurrency is 1: the servers are local SQLite.

Grading is a **normalised string match** (`scripts/evals/answer-match.mjs`): trim, case-fold,
collapse whitespace, unwrap one layer of quotes/backticks/bold, strip trailing sentence
punctuation, and numeric equality when both sides parse (`74` = `74.0`). Nothing is
extracted from prose — `The value is 3` does not match `3`; following "Answer with the value
only" is part of what is measured.

### What is recorded

Per question: final answer, pass, tool calls as **names + argument keys only** (never values
or payloads — privacy), turns, `structuredContent` and text bytes, API usage
(input / output / cache read / cache write tokens), estimated cost, wall time, model. Per
service the **discipline metrics** (`scripts/evals/discipline.mjs`):

| Metric | Definition |
|---|---|
| `pass_rate` | passed / questions, in % |
| `median_tool_calls` | median tool calls per question |
| `median_structured_bytes` | median summed `structuredContent` bytes per question |
| `discipline_rate` | calls that pulled a lever the tool **offers** / calls to tools that offer any lever. Levers, derived from each tool's `inputSchema.properties`: a limit (`limit`, `*_limit`, `max_*`), a filter (`filter`, `modules`, `object_type`, `kind`, `direction`, `*_like`, `*_only`, `*_filter`, …), a batch array (`enum_names`, `tables`, `method_names`, `queries`, `objects`, `object_names`, `role_names`) or `cursor`. Lever-less tools (`d365_get_join_keys`, `taskrecorder_to_markdown`) leave the denominator |
| `first_call_correct_rate` | share of questions whose first tool call names the first recorded call in `<svc>.calls.json` (null in replay — the recorded calls are the reference) |
| `over_fetch_count` / `budgeted_questions` | questions whose bytes exceeded `max_structured_bytes` in `<svc>.budget.json`, over the budgeted ones |

The run writes `evals/results/<svc>-<YYYY-MM-DD>.json` (`schema: d365fo-evals-results/1`;
`test/evals-format.test.js` checks the shape and the no-payload rule of every committed
file) and prints a Markdown table plus the metric line. A failed question is data, not a
failure: the LLM leg exits 0 unless `--compare` finds a regression.

### `--compare` — the regression gate

`--compare <file>` or `--compare auto` (newest `evals/results/<svc>-*.json`) exits 2 when
`pass_rate` drops by more than **10 points** or `median_structured_bytes` rises by more than
**25 %** (`scripts/evals/compare.mjs`). It works in both modes — comparing a replay to an LLM
run warns that the pass rates are not comparable, the bytes are. Commit a results file after
a deliberate run; the weekly workflow compares against it.

### Cost per question

**Estimate — no measured run yet.** The LLM leg has not been executed in this repo: on the
authoring machine no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ant` profile was
available (2026-09-02). The numbers below are derived, not observed; replace them with the
`est. cost` line of the first real run.

Measured inputs (2026-09-02, local snapshots): the Anthropic `tools` array is much smaller
than the MCP `tools/list` because it carries no `outputSchema`, `annotations` or `title` —
KB 24 tools 23,944 B (~6.0k tk), XRef 17 tools 15,896 B (~4.0k tk), Sec 18 tools 12,984 B
(~3.2k tk), Task Recorder 2 tools 3,154 B (~0.8k tk); system prompts 250–370 chars. The
replay's KB questions return ~10.6 KB of text per question (~2.7k tk the model reads).

Derived, `claude-sonnet-5` ($2 / $10 per MTok, cache read 0.1×, cache write 1.25×), a
3-turn KB question (call → tool → call → tool → answer): ~24k input tokens of which the
~6.4k tools+system prefix is written once and read twice, ~4.6k uncached message tokens,
~450 output tokens → **≈ $0.03 per question with caching, ≈ $0.05 without**; a full
40-question run ≈ $1.2–2. XRef and Sec questions are cheaper on the prefix and comparable
on results. Multiply by 2.5 for `claude-opus-5`.

### Caveats before reading a result as a tool-quality signal

1. **Task Recorder questions name fixture paths.** The harness passes only the question
   text, so the model must be able to read `test/fixtures/*.axtr` (a file tool alongside the
   MCP server, or the base64 pre-loaded into the prompt). Without that, all ten fail for a
   reason unrelated to the server — expect `taskrecorder` at 0 % on the LLM leg until the
   question set carries the recording inline.
2. **Sec role names are display names** (`Accounts receivable manager`, not
   `AccountsReceivableClerk`). A model that guesses the AOT form gets *not found* and must
   recover through `sec_search {object_type:role}` — that recovery is part of what the eval
   measures.
3. **`result_count` is the returned count on the XRef list tools.** A count question is only
   right with `limit` above the total and `truncated:false`; a model that reads
   `result_count` at the default limit answers wrong. Again by design.

The XML files are also exactly what the mcp-builder Python harness consumes
(`~/.claude/skills/mcp-builder/scripts/evaluation.py -t stdio -c node -a src/local/mcp-server-kb.js evals/kb.xml`)
if a second opinion on the grading is wanted.

## CI — `.github/workflows/evals.yml`

- **`replay`** on every PR and push to `main`: `npm ci`, `node --test test/evals-format.test.js
  test/evals-harness.test.js`, then `node scripts/run-evals.mjs all` — which skips the three
  snapshot-backed services with a notice (CI has no `.sqlite`) and runs Task Recorder.
- **`llm`** on `workflow_dispatch` (inputs `service`, `model`) and weekly (Mondays 05:00 UTC),
  gated on the `ANTHROPIC_API_KEY` secret: the secret is mapped to an env var and a first step
  decides, because secrets cannot be read in a job-level `if`. Without the secret the job
  prints a notice and ends green. With it, it runs `--llm --compare auto` and uploads
  `evals/results/*.json` as an artifact. It still needs a snapshot on the runner — until one
  exists (self-hosted runner or a restore step) it reports the same skip, and the operator
  runs the leg locally and commits the results file.

Pushing `.github/workflows/*` needs the `workflow` OAuth scope on the gh token:
`gh auth refresh -h github.com -s workflow`. If the push is rejected, the workflow file lands
in the PR from a local commit and the operator pushes.

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
